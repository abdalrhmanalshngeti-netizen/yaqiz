const db = require('../config/db');
const { nextDocNumber } = require('../services/docNumber.service');

exports.list = async (req, res, next) => {
  try {
    const { rows: pos } = await db.query(
      `SELECT * FROM purchase_orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1000`,
      [req.user.company_id]
    );
    if (!pos.length) return res.json({ success: true, data: [] });

    const ids = pos.map(p => p.id);
    const { rows: items } = await db.query(
      `SELECT * FROM purchase_order_items WHERE po_id = ANY($1) ORDER BY id`,
      [ids]
    );
    const byPo = {};
    items.forEach(i => { (byPo[i.po_id] = byPo[i.po_id] || []).push(i); });

    res.json({ success: true, data: pos.map(p => ({ ...p, items: byPo[p.id] || [] })) });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { supplier_name, items = [], notes, expected_date, status, client_local_id } = req.body;
    if (!items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'يجب إضافة صنف واحد على الأقل' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ أمر
    // شراء مكرَّرًا — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM purchase_orders WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.status(201).json({ success: true, data: existing }); }
    }

    const grand_total = items.reduce((s, i) => s + (parseFloat(i.total ?? i.line_total) || 0), 0);

    const poSeqN = await nextDocNumber(client, req.user.company_id, 'po');
    const po_no = `PO-${new Date().getFullYear()}-${String(poSeqN).padStart(4, '0')}`;

    const { rows: [po] } = await client.query(`
      INSERT INTO purchase_orders (company_id, po_no, supplier_name, date, expected_date, status, subtotal, vat_amount, grand_total, notes, created_by, client_local_id)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,0,$6,$7,$8,$9)
      RETURNING *
    `, [req.user.company_id, po_no, supplier_name || '', expected_date || null,
        status || 'معلق', grand_total, notes || '', req.user.sub, client_local_id || null]);

    for (const i of items) {
      await client.query(`
        INSERT INTO purchase_order_items (po_id, product_name, ordered_qty, unit_price, line_total)
        VALUES ($1,$2,$3,$4,$5)
      `, [po.id, i.name || i.product_name || '', parseFloat(i.qty) || 0, parseFloat(i.price || i.unit_price) || 0, parseFloat(i.total || i.line_total) || 0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...po, items } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows: [po] } = await db.query(
      `UPDATE purchase_orders SET status = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
      [status, req.params.id, req.user.company_id]
    );
    if (!po) return res.status(404).json({ success: false, message: 'أمر الشراء غير موجود' });
    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(`DELETE FROM purchase_orders WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
