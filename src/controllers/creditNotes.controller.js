const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM credit_notes WHERE company_id = $1 ORDER BY icv DESC NULLS LAST, id DESC LIMIT 2000`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [note] } = await db.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!note) return res.status(404).json({ success: false, message: 'إشعار الدائن غير موجود' });
    const { rows: items } = await db.query(
      `SELECT * FROM credit_note_items WHERE credit_note_id = $1 ORDER BY sort_order`,
      [note.id]
    );
    res.json({ success: true, data: { ...note, items } });
  } catch (err) { next(err); }
};
