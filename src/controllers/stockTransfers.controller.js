const db    = require('../config/db');
const stock = require('../services/stock.service');

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT st.*, wf.name AS from_warehouse_name, wt.name AS to_warehouse_name,
        COALESCE(
          (SELECT json_agg(json_build_object('product_id', sti.product_id, 'product_name', sti.product_name, 'qty', sti.qty::float))
           FROM stock_transfer_items sti WHERE sti.transfer_id = st.id),
          '[]'::json
        ) AS items
      FROM stock_transfers st
      JOIN warehouses wf ON wf.id = st.from_warehouse_id
      JOIN warehouses wt ON wt.id = st.to_warehouse_id
      WHERE st.company_id = $1
      ORDER BY st.created_at DESC
    `, [req.user.company_id]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [t] } = await db.query(
      `SELECT * FROM stock_transfers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!t) return res.status(404).json({ success: false, message: 'سجل النقل غير موجود' });
    const { rows: items } = await db.query(
      `SELECT product_id, product_name, qty::float FROM stock_transfer_items WHERE transfer_id = $1`,
      [t.id]
    );
    res.json({ success: true, data: { ...t, items } });
  } catch (err) { next(err); }
};

// نقل بضاعة حقيقي بين مستودعين — بلاست راديوس أكبر من إدارة فرع واحد،
// owner-only بالكنترولر مباشرة (نفس نمط إدارة الفروع/المستودعات).
// لا تعديل ولا حذف بعد الإنشاء — يطابق عدم وجود "تعديل فاتورة" بالنظام أصلًا.
exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'نقل البضاعة بين الفروع للمالك فقط' });
    }
    const { from_warehouse_id, to_warehouse_id, notes, items = [] } = req.body;
    if (!from_warehouse_id || !to_warehouse_id) {
      return res.status(400).json({ success: false, message: 'المستودع المصدر والوجهة مطلوبان' });
    }
    if (Number(from_warehouse_id) === Number(to_warehouse_id)) {
      return res.status(400).json({ success: false, message: 'لا يمكن النقل لنفس المستودع' });
    }
    if (!items.length) {
      return res.status(400).json({ success: false, message: 'أضف صنفًا واحدًا على الأقل' });
    }

    await client.query('BEGIN');

    const { company_id, sub: user_id } = req.user;
    const { rows: whRows } = await client.query(
      `SELECT id FROM warehouses WHERE id = ANY($1) AND company_id = $2 AND is_active = true`,
      [[from_warehouse_id, to_warehouse_id], company_id]
    );
    if (whRows.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'مستودع غير موجود' });
    }

    const { rows: [seq] } = await client.query(`SELECT NEXTVAL('transfer_seq') AS n`);
    const transfer_no = `TRF-${String(seq.n).padStart(6, '0')}`;

    const { rows: [transfer] } = await client.query(`
      INSERT INTO stock_transfers (company_id, transfer_no, from_warehouse_id, to_warehouse_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [company_id, transfer_no, from_warehouse_id, to_warehouse_id, notes || null, user_id]);

    for (const item of items) {
      if (!item.product_id || !item.qty || item.qty <= 0) continue;

      const { rows: [prod] } = await client.query(
        `SELECT name FROM products WHERE id = $1 AND company_id = $2`,
        [item.product_id, company_id]
      );
      if (!prod) continue;

      await stock.deduct(client, {
        company_id, product_id: item.product_id, warehouse_id: from_warehouse_id, qty: item.qty,
        reason: `نقل بضاعة إلى مستودع آخر`, source_type: 'transfer', source_id: transfer.id,
        reference: transfer_no, user_id
      });
      await stock.add(client, {
        company_id, product_id: item.product_id, warehouse_id: to_warehouse_id, qty: item.qty,
        reason: `نقل بضاعة من مستودع آخر`, source_type: 'transfer', source_id: transfer.id,
        reference: transfer_no, user_id
      });

      await client.query(`
        INSERT INTO stock_transfer_items (transfer_id, product_id, product_name, qty)
        VALUES ($1,$2,$3,$4)
      `, [transfer.id, item.product_id, prod.name, item.qty]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: transfer });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
