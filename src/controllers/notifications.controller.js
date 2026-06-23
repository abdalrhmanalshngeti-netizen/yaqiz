const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM notifications
      WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2)
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.company_id, req.user.sub]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.unreadCount = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS count FROM notifications
      WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2) AND is_read = false
    `, [req.user.company_id, req.user.sub]);
    res.json({ success: true, count: rows[0].count });
  } catch (err) { next(err); }
};

exports.markAllRead = async (req, res, next) => {
  try {
    await db.query(`
      UPDATE notifications SET is_read = true
      WHERE company_id = $1 AND (user_id IS NULL OR user_id = $2) AND is_read = false
    `, [req.user.company_id, req.user.sub]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.markOneRead = async (req, res, next) => {
  try {
    await db.query(`
      UPDATE notifications SET is_read = true
      WHERE id = $1 AND company_id = $2
    `, [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
