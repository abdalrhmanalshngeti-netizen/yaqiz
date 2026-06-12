const db = require('../config/db');

// POST /api/support/ticket — المستخدم يرسل تذكرة
exports.createTicket = async (req, res, next) => {
  try {
    const { department, sub_dept, description, note } = req.body;
    const { sub: userId, company_id, username, full_name, role } = req.user;

    // جلب اسم الشركة
    const { rows: [co] } = await db.query(
      `SELECT name FROM companies WHERE id = $1`,
      [company_id]
    );

    const { rows: [ticket] } = await db.query(`
      INSERT INTO support_tickets
        (company_id, company_name, user_name, user_role, department, sub_dept, description, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, created_at
    `, [
      company_id,
      co?.name || '',
      full_name || username,
      role,
      department || '',
      sub_dept   || '',
      description || '',
      note || ''
    ]);

    res.status(201).json({ success: true, id: ticket.id, created_at: ticket.created_at });
  } catch (err) { next(err); }
};
