const db = require('../config/db');

// GET /api/support/tickets — المالك يجلب كل تذاكر شركته
exports.listCompanyTickets = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'المالك فقط يمكنه عرض التذاكر' });
    }
    const { rows } = await db.query(
      `SELECT * FROM support_tickets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// PUT /api/support/tickets/:id/status — المالك يحدّث حالة التذكرة
exports.updateCompanyTicketStatus = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'المالك فقط يمكنه تحديث التذاكر' });
    }
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    const resolved_at = status === 'resolved' ? new Date() : null;
    const { rowCount } = await db.query(
      `UPDATE support_tickets SET status = $1, resolved_at = $2
       WHERE id = $3 AND company_id = $4`,
      [status, resolved_at, req.params.id, req.user.company_id]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

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
