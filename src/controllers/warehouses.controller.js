const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { branch_id, active = 'true' } = req.query;
    let where  = [`company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;
    if (active !== 'all') { where.push(`is_active = $${idx++}`); params.push(active === 'true'); }
    if (branch_id) { where.push(`branch_id = $${idx++}`); params.push(branch_id); }

    const { rows } = await db.query(
      `SELECT * FROM warehouses WHERE ${where.join(' AND ')} ORDER BY name`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM warehouses WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستودع غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

// عادة ما يُنشأ المستودع تلقائيًا مع الفرع (branches.controller.js) — هذا
// المسار مخصص للحالة المستقبلية (أكثر من مستودع لكل فرع)، ويمنع حاليًا أي
// مستودع نشط ثانٍ لنفس الفرع لحين رفع هذا القيد لاحقًا
exports.create = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'إضافة مستودع للمالك فقط' });
    }
    const { branch_id, name, code } = req.body;
    if (!branch_id || !name) {
      return res.status(400).json({ success: false, message: 'الفرع واسم المستودع مطلوبان' });
    }
    const { rows: [branch] } = await db.query(
      `SELECT id FROM branches WHERE id = $1 AND company_id = $2`,
      [branch_id, req.user.company_id]
    );
    if (!branch) return res.status(404).json({ success: false, message: 'الفرع غير موجود' });

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM warehouses WHERE branch_id = $1 AND is_active = true`,
      [branch_id]
    );
    if (count >= 1) {
      return res.status(400).json({ success: false, message: 'هذا الفرع لديه مستودع بالفعل — تعدد المستودعات لكل فرع غير متاح حاليًا' });
    }

    const { rows: [warehouse] } = await db.query(`
      INSERT INTO warehouses (company_id, branch_id, name, code)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `, [req.user.company_id, branch_id, name, code || null]);

    res.status(201).json({ success: true, data: warehouse });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'تعديل المستودعات للمالك فقط' });
    }
    const { name, code, is_active } = req.body;
    const { rows } = await db.query(`
      UPDATE warehouses SET
        name      = COALESCE($1, name),
        code      = COALESCE($2, code),
        is_active = COALESCE($3, is_active)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [name, code, is_active, req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستودع غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};
