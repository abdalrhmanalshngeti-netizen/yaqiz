const db = require('../config/db');

// سجل تدقيق حقيقي — قراءة فقط، بحسب الكيان (فاتورة/منتج/إلخ) أو سجل الشركة كاملاً
exports.list = async (req, res, next) => {
  try {
    const { entity_type, entity_id, limit = 100 } = req.query;
    const where  = [`company_id = $1`];
    const params = [req.user.company_id];
    let idx = 2;

    if (entity_type) { where.push(`entity_type = $${idx++}`); params.push(entity_type); }
    if (entity_id)   { where.push(`entity_id = $${idx++}`);   params.push(entity_id); }

    params.push(Math.min(parseInt(limit) || 100, 500));
    const { rows } = await db.query(`
      SELECT id, username, action, entity_type, entity_id, old_values, new_values, details, created_at
      FROM activity_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};
