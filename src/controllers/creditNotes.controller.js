const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { reference_invoice_id, reference_return_id } = req.query;
    const where = ['company_id = $1'];
    const params = [req.user.company_id];
    if (reference_invoice_id) { params.push(reference_invoice_id); where.push(`reference_invoice_id = $${params.length}`); }
    if (reference_return_id)  { params.push(reference_return_id);  where.push(`reference_return_id = $${params.length}`); }
    const { rows } = await db.query(
      `SELECT * FROM credit_notes WHERE ${where.join(' AND ')} ORDER BY icv DESC NULLS LAST, id DESC LIMIT 2000`,
      params
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
