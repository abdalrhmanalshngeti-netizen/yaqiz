const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { warehouse_id, branch_id, active = 'true' } = req.query;
    let where  = [`p.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;
    if (active !== 'all') { where.push(`p.is_active = $${idx++}`); params.push(active === 'true'); }
    if (warehouse_id) { where.push(`p.warehouse_id = $${idx++}`); params.push(warehouse_id); }
    if (branch_id) { where.push(`w.branch_id = $${idx++}`); params.push(branch_id); }

    const { rows } = await db.query(`
      SELECT p.*, w.branch_id, w.name AS warehouse_name
      FROM pos_points p
      JOIN warehouses w ON w.id = p.warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM pos_points WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'نقطة البيع غير موجودة' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'إضافة نقطة بيع للمالك فقط' });
    }
    const { warehouse_id, name, code } = req.body;
    if (!warehouse_id || !name) {
      return res.status(400).json({ success: false, message: 'المستودع واسم نقطة البيع مطلوبان' });
    }
    const { rows: [wh] } = await db.query(
      `SELECT id FROM warehouses WHERE id = $1 AND company_id = $2`,
      [warehouse_id, req.user.company_id]
    );
    if (!wh) return res.status(404).json({ success: false, message: 'المستودع غير موجود' });

    const { rows: [point] } = await db.query(`
      INSERT INTO pos_points (company_id, warehouse_id, name, code)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `, [req.user.company_id, warehouse_id, name, code || null]);

    res.status(201).json({ success: true, data: point });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'تعديل نقاط البيع للمالك فقط' });
    }
    const { name, code, is_active } = req.body;
    const { rows } = await db.query(`
      UPDATE pos_points SET
        name      = COALESCE($1, name),
        code      = COALESCE($2, code),
        is_active = COALESCE($3, is_active)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [name, code, is_active, req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'نقطة البيع غير موجودة' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'حذف نقاط البيع للمالك فقط' });
    }
    await db.query(`UPDATE pos_points SET is_active = false WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
