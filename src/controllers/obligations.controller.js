const db = require('../config/db');

// نفس القيم الوحيدة التي تعرضها قائمة الاختيار بالواجهة — أي قيمة أخرى نص حر
// غير معروف قد يُستخدم لاحقًا كمدخل غير موثوق (مثلاً لو عُرض يومًا بلا تعقيم)
const ALLOWED_FREQUENCIES = ['شهري', 'أسبوعي', 'ربع سنوي', 'نصف سنوي', 'سنوي'];

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM obligations WHERE company_id = $1 ORDER BY next_due ASC`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { name, category, amount, frequency, next_due, vendor, status } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'اسم الالتزام مطلوب' });
    if (frequency && !ALLOWED_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ success: false, message: 'تكرار غير صالح' });
    }

    const { rows } = await db.query(`
      INSERT INTO obligations (company_id, name, category, amount, frequency, next_due, vendor, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [req.user.company_id, name, category || '', parseFloat(amount) || 0,
        frequency || 'شهري', next_due || null, vendor || '', status || 'active']);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { name, category, amount, frequency, next_due, vendor, status } = req.body;
    if (frequency && !ALLOWED_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ success: false, message: 'تكرار غير صالح' });
    }

    const { rows } = await db.query(`
      UPDATE obligations SET
        name      = COALESCE($1, name),
        category  = COALESCE($2, category),
        amount    = COALESCE($3, amount),
        frequency = COALESCE($4, frequency),
        next_due  = COALESCE($5::date, next_due),
        vendor    = COALESCE($6, vendor),
        status    = COALESCE($7, status)
      WHERE id = $8 AND company_id = $9
      RETURNING *
    `, [name, category, amount != null ? parseFloat(amount) : null,
        frequency, next_due || null, vendor, status,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'الالتزام غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(
      `DELETE FROM obligations WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};
